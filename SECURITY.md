# Security policy

## Supported versions

Torch is pre-v1 and not ready for use. No released version is supported yet, so no version receives security fixes
today. Once v1 ships, this section will list the supported versions.

Reports about the current `main` branch are still welcome: the code is public, and a flaw found now is a flaw that
never reaches a release.

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub private vulnerability reporting:

1. Open the repository's **Security** tab (`dotzerolab/torch` on GitHub).
2. Choose **Report a vulnerability**.
3. Describe the problem.

Do not open a public issue, pull request or discussion for a vulnerability, and do not post details anywhere public
before it is fixed.

Useful to include:

- what is affected (component, file, endpoint, or commit) and what an attacker gains;
- steps or a minimal proof of concept that reproduces it;
- the commit or version you tested, and how you ran Torch (development setup, your own deployment);
- anything you already know about a fix.

## What happens next

Torch is maintained by volunteers, so these are intentions, not guarantees:

- we aim to acknowledge a report within 7 days and to tell you whether we consider it a vulnerability;
- we keep you informed while we work on a fix, and we agree with you on a disclosure date;
- when the fix is released we publish an advisory and credit you, unless you prefer not to be named.

If you do not hear back within 14 days, comment on your own private report to nudge it; that stays private too.

## Scope

In scope: the code in this repository, in particular authentication and sessions, the MCP server and its OAuth,
API and MCP tokens, permissions and workspace isolation, sync, file uploads, webhooks and their signing, the Linear
import, and anything that stores or handles secrets.

Out of scope:

- the credentials in `docker-compose.dev.yml` and `.env.example`: they are placeholders for local development only;
- flaws in third-party dependencies (report them upstream; tell us too if Torch is exposed through them);
- a deployment run by someone else that is misconfigured (open ports, default passwords, missing TLS).

A secret committed by mistake is a vulnerability too: report it the same way.

## Good-faith research

We welcome good-faith research that follows this policy: test against your own instance, never against other
people's data or deployments, do not degrade a service for others, and stop and report as soon as you reach another
person's data. We will not take action against research done this way.
