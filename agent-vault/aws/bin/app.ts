#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { DataStack } from "../lib/data-stack";
import { VaultStack } from "../lib/vault-stack";
import { GithubStack } from "../lib/github-stack";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" };
Tags.of(app).add("project", "agent-vault");

const data = new DataStack(app, "AgentVaultData", { env, description: "agent-vault: VPC, EFS vault data, backups" });

const zoneId: string | undefined = app.node.tryGetContext("zoneId");
if (zoneId) {
  new VaultStack(app, "AgentVault", {
    env,
    description: "agent-vault: Vaultwarden on Lambda + HTTPS endpoint",
    data,
    domainName: app.node.getContext("domainName"),
    zoneName: app.node.getContext("zoneName"),
    zoneId,
    alertEmail: app.node.tryGetContext("alertEmail") || undefined,
    signups: String(app.node.tryGetContext("signups")) === "true",
  });
}

new GithubStack(app, "AgentVaultGithub", {
  env,
  description: "agent-vault: GitHub Actions OIDC deploy role",
  repo: app.node.tryGetContext("githubRepo") ?? "nyo-solutions/agent-vault",
  existingProviderArn: app.node.tryGetContext("oidcProviderArn") || undefined,
});
