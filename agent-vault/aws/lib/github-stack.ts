import { Arn, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface GithubStackProps extends StackProps {
  repo: string;               // "your-org/your-ops-repo"
  /** OIDC sub prefix GitHub actually sends, e.g. "repo:org@123/repo@456" when the repo uses immutable subjects. */
  subPrefix?: string;
  existingProviderArn?: string; // reuse an account-wide GitHub OIDC provider if one exists
}

/** Lets GitHub Actions (main branch of one repo) deploy/destroy/back up the vault. No stored keys. */
export class GithubStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubStackProps) {
    super(scope, id, props);
    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "Provider", props.existingProviderArn)
      : new iam.OpenIdConnectProvider(this, "Provider", { url: "https://token.actions.githubusercontent.com", clientIds: ["sts.amazonaws.com"] });

    const role = new iam.Role(this, "Role", {
      roleName: "agent-vault-github",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                        "token.actions.githubusercontent.com:sub": `${props.subPrefix ?? `repo:${props.repo}`}:ref:refs/heads/main` },
      }),
    });

    // Deploy / destroy go through the CDK bootstrap roles.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
    }));
    // Read stack outputs; invoke the backup/migrate function.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks"],
      resources: [
        Arn.format({ service: "cloudformation", resource: "stack", resourceName: "AgentVault/*" }, this),
        Arn.format({ service: "cloudformation", resource: "stack", resourceName: "AgentVaultData/*" }, this),
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [Arn.format({ service: "lambda", resource: "function", resourceName: "AgentVaultData-Migrate*", arnFormat: undefined }, this)],
    }));
    // restore: recycle warm Vaultwarden instances after importing a backup.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:GetFunctionConfiguration", "lambda:UpdateFunctionConfiguration"],
      resources: [Arn.format({ service: "lambda", resource: "function", resourceName: "AgentVault-Vaultwarden*", arnFormat: undefined }, this)],
    }));
    // remove-vault: delete the retained file system, transfer bucket and (optionally) backups.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeMountTargets", "backup:ListRecoveryPointsByResource"],
      resources: ["*"],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["elasticfilesystem:DeleteFileSystem"],
      resources: ["*"],
      conditions: { StringEquals: { "aws:ResourceTag/project": "agent-vault" } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket", "s3:ListBucketVersions", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteBucket"],
      resources: ["arn:aws:s3:::agentvaultdata-transfer*", "arn:aws:s3:::agentvaultdata-transfer*/*"],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["backup:DeleteRecoveryPoint"],
      resources: [Arn.format({ service: "backup", resource: "recovery-point", resourceName: "*", arnFormat: undefined }, this)],
    }));

    new CfnOutput(this, "RoleArn", { value: role.roleArn });
  }
}
