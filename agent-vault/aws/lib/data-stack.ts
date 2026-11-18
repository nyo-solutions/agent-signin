import * as path from "path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as efs from "aws-cdk-lib/aws-efs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";

/**
 * Everything that holds vault data. Survives "destroy stack"; removed only by remove-vault.
 * VPC has no NAT / no internet egress; a free S3 gateway endpoint lets the migrate
 * function reach the transfer bucket.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly fileSystem: efs.FileSystem;
  readonly accessPoint: efs.AccessPoint;
  /** Security group for the Vaultwarden function (lives here so the EFS rule has no cross-stack cycle). */
  readonly vaultClientSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    // Diagnostics (2026-11-06): record every connection attempt from the Lambdas, to see
    // whether a hanging request is trying to reach the internet (this VPC has no egress).
    this.vpc.addFlowLog("FlowLog", {
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogs", { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })),
      maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
    });

    this.fileSystem = new efs.FileSystem(this, "Data", {
      vpc: this.vpc,
      vpcSubnets: isolated,
      encrypted: true,
      throughputMode: efs.ThroughputMode.BURSTING,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      enableAutomaticBackups: true, // AWS Backup daily, 35-day retention
      removalPolicy: RemovalPolicy.RETAIN, // only remove-vault deletes it, explicitly
    });
    this.accessPoint = this.fileSystem.addAccessPoint("VaultwardenAp", {
      path: "/vaultwarden",
      createAcl: { ownerUid: "1000", ownerGid: "1000", permissions: "750" },
      posixUser: { uid: "1000", gid: "1000" },
    });

    this.vaultClientSg = new ec2.SecurityGroup(this, "VaultClientSg", { vpc: this.vpc, description: "Vaultwarden Lambda", allowAllOutbound: true });
    this.fileSystem.connections.allowDefaultPortFrom(this.vaultClientSg);

    const transfer = new s3.Bucket(this, "Transfer", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        { prefix: "import/", expiration: Duration.days(1) },
        { prefix: "exports/", expiration: Duration.days(30) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const migrate = new lambda.Function(this, "Migrate", {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../migrate"), { exclude: ["__pycache__"] }),
      memorySize: 512,
      timeout: Duration.minutes(2),
      vpc: this.vpc,
      vpcSubnets: isolated,
      filesystem: lambda.FileSystem.fromEfsAccessPoint(this.accessPoint, "/mnt/vw"),
      environment: { BUCKET: transfer.bucketName },
      logGroup: new logs.LogGroup(this, "MigrateLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
    });
    this.fileSystem.connections.allowDefaultPortFrom(migrate);
    transfer.grantReadWrite(migrate);
    transfer.grantDelete(migrate);

    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new CfnOutput(this, "FileSystemId", { value: this.fileSystem.fileSystemId });
    new CfnOutput(this, "FileSystemArn", { value: this.fileSystem.fileSystemArn });
    new CfnOutput(this, "TransferBucket", { value: transfer.bucketName });
    new CfnOutput(this, "MigrateFunction", { value: migrate.functionName });
  }
}
