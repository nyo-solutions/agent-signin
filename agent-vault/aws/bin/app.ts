#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { DataStack } from "../lib/data-stack";
import { VaultStack } from "../lib/vault-stack";
import { GithubStack } from "../lib/github-stack";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" };
Tags.of(app).add("project", "agent-vault");

const data = new DataStack(app, "AgentVaultData", { env, description: "agent-vault: VPC, EFS vault data, backups" });

// Settings: CDK context (-c domainName=...) or environment (VAULT_DOMAIN, ZONE_NAME, GITHUB_REPO).
function required(ctx: string, envName: string): string {
  const v = app.node.tryGetContext(ctx) || process.env[envName];
  if (!v) throw new Error(`Set ${envName} (agent-vault/local.env) or pass -c ${ctx}=...`);
  return v;
}

const zoneId: string | undefined = app.node.tryGetContext("zoneId");
if (zoneId) {
  new VaultStack(app, "AgentVault", {
    env,
    description: "agent-vault: Vaultwarden on Lambda + HTTPS endpoint",
    data,
    domainName: required("domainName", "VAULT_DOMAIN"),
    zoneName: required("zoneName", "ZONE_NAME"),
    zoneId,
    alertEmail: app.node.tryGetContext("alertEmail") || undefined,
    signups: String(app.node.tryGetContext("signups")) === "true",
  });
}

// Only synthesised when a repo is given (setup-github.sh does that).
const githubRepo: string | undefined = app.node.tryGetContext("githubRepo") || process.env.GITHUB_REPO;
if (githubRepo) {
  new GithubStack(app, "AgentVaultGithub", {
    env,
    description: "agent-vault: GitHub Actions OIDC deploy role",
    repo: githubRepo,
    subPrefix: app.node.tryGetContext("githubSubPrefix") || undefined,
    existingProviderArn: app.node.tryGetContext("oidcProviderArn") || undefined,
  });
}
