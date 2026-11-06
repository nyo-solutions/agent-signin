import * as path from "path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { DataStack } from "./data-stack";

export interface VaultStackProps extends StackProps {
  data: DataStack;
  domainName: string;
  zoneName: string;
  zoneId: string;
  alertEmail?: string;
  signups?: boolean;
}

/** The public, stateless part: Vaultwarden on Lambda + HTTPS endpoint. Safe to destroy/recreate. */
export class VaultStack extends Stack {
  constructor(scope: Construct, id: string, props: VaultStackProps) {
    super(scope, id, props);
    const { data, domainName, zoneName, zoneId, alertEmail, signups } = props;

    const vaultwarden = new lambda.DockerImageFunction(this, "Vaultwarden", {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "../image"), { platform: Platform.LINUX_ARM64 }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(29),
      vpc: data.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [data.vaultClientSg],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(data.accessPoint, "/mnt/vw"),
      logGroup: new logs.LogGroup(this, "VaultwardenLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        DOMAIN: `https://${domainName}`,
        SIGNUPS_ALLOWED: signups ? "true" : "false",
        INVITATIONS_ALLOWED: "false",
        PASSWORD_HINTS_ALLOWED: "false",
        SHOW_PASSWORD_HINT: "false",
        ENABLE_WEBSOCKET: "false", // Lambda can't hold sockets; clients sync on unlock/interval
        DISABLE_ICON_DOWNLOAD: "true", // no egress anyway
        ICON_SERVICE: "internal",
        ENABLE_DB_WAL: "false", // SQLite WAL is unsafe on network filesystems
        IP_HEADER: "X-Forwarded-For",
        LOG_LEVEL: "warn",
        // No ADMIN_TOKEN => /admin is disabled.
      },
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: zoneId, zoneName });
    const certificate = new acm.Certificate(this, "Cert", { domainName, validation: acm.CertificateValidation.fromDns(zone) });
    const domain = new apigw.DomainName(this, "Domain", { domainName, certificate });
    const api = new apigw.HttpApi(this, "Api", {
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
      defaultIntegration: new HttpLambdaIntegration("VaultwardenIntegration", vaultwarden),
    });
    new apigw.HttpStage(this, "Stage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 50 }, // caps abuse and cost
      domainMapping: { domainName: domain },
    });
    new route53.ARecord(this, "AliasA", {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)),
    });

    if (alertEmail) {
      new budgets.CfnBudget(this, "Budget", {
        budget: { budgetName: "agent-vault-monthly", budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: 5, unit: "USD" } },
        notificationsWithSubscribers: [
          { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 50 }, subscribers: [{ subscriptionType: "EMAIL", address: alertEmail }] },
          { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100 }, subscribers: [{ subscriptionType: "EMAIL", address: alertEmail }] },
        ],
      });
    }

    new CfnOutput(this, "Url", { value: `https://${domainName}` });
    new CfnOutput(this, "VaultwardenFunction", { value: vaultwarden.functionName });
  }
}
