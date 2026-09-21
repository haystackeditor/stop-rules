# Deploying the stop-rules team server

One person deploys one small endpoint that holds the Jev API key. After that every
developer's Stop hook is a thin client with no Jev key: it sends its questions to your
endpoint with a team token. All the checking logic, and your `.stop-rules.md`, stay in your
own repository.

The server is a locked down proxy and nothing more. It answers `GET /health` and
`POST /v1/systemone`, it requires the team token on the questions route, it caps the body
at 1,000,000 bytes, it rejects anything that is not a set of `noul` questions, it sets the
Jev model itself, and it relays the upstream status, body and `Retry-After` unchanged so
the client's own rate limit backoff and request splitting keep working.

## The rate limit is per Jev account, so the server holds a line

One server instance keeps at most 12 calls open to Jev at a time. Past that it answers 429
with `Retry-After: 1`, and the client backs off through the same code path it uses for a 429
from Jev itself, so nothing is lost.

Read that number honestly:

- The measured Jev limit is per account, not per server: about 16 calls in flight is fine,
  and 32 gets about half of them refused.
- On a serverless platform (Cloudflare Workers, Vercel, Netlify, Lambda, Deno Deploy,
  Supabase) the cap is **per instance**. The platform can run many instances at once, and
  they do not know about each other, so a big team can still go past the account limit. The
  clients handle that as a 429 and slow down.
- One container or VM is one instance, so there the cap is the whole team's.

## Every deploy needs the same two secrets

| Name | What it is |
|---|---|
| `TYPESAFE_API_KEY` | Your Jev API key from TypeSafe. It never leaves the server. |
| `STOP_RULES_TOKEN` | The token your developers send. Make one with `openssl rand -hex 24`. |

Optional: `STOP_RULES_JEV_MODEL` (default `jev-latest`), `STOP_RULES_JEV_UPSTREAM`
(default `https://api.typesafe.ai/v1/systemone`), `PORT` (default 8080, container targets
only).

Open `<endpoint>/health` in a browser after deploying. It reports which of the two names is
still missing, never their values:

```
{"ok":true,"service":"stop-rules","version":"0.1.0","configured":true,"missing":[]}
```

## Then point each repository at it

```bash
# once per repository, and commit the file: it holds no secret
stop-rules team https://your-endpoint.example.com

# once per developer, per machine
printf %s "$STOP_RULES_TOKEN" | stop-rules login --token-stdin
stop-rules login --check
```

`stop-rules team` writes `.stop-rules.json`. `stop-rules login` writes
`~/.config/stop-rules/token` (or `$XDG_CONFIG_HOME/stop-rules/token`) with mode 0600, which
matters because an editor started from a dock does not inherit your shell exports.
`STOP_RULES_ENDPOINT` and `STOP_RULES_TOKEN` in the environment beat both files.

## Targets

Status words are used exactly as follows:

- **ran locally in the platform's own runtime**: the shipped entry file served real traffic
  under that platform's runtime on this machine, including a real Jev call.
- **config validated only**: the platform's config file parses with a real parser and its
  keys match the platform's current documentation, but that platform's own tooling never
  ran here.
- **docs-confirmed only**: the file names, handler shape and link format are quoted from
  the platform's primary documentation, and nothing was executed.
- **unconfirmed**: the documentation did not settle it. Nothing is listed as unconfirmed
  without saying which part.

No button below has been clicked yet. The repository went public on 21 September 2026, so
the buttons can now be tried; until one is, its row's status word is the whole claim.

| Target | How | Prompts for | Endpoint afterwards | Status |
|---|---|---|---|---|
| Cloudflare Workers | Deploy button, or `npx wrangler deploy` | both secrets, from `.dev.vars.example` | `https://stop-rules.<subdomain>.workers.dev` | **deployed for real** on 21 September 2026 with `npx wrangler deploy`, both secrets set, a client repo pointed at it, one real check answered through it (0.91 on the `fetch` example), a wrong token refused, then deleted |
| Vercel | Deploy button | both secrets, from the `env` query parameter | `https://<app>.vercel.app/api` | config validated only, wrapper executed under Node |
| Netlify | Deploy to Netlify button | both secrets, from `netlify.toml` | the site URL | config validated only, wrapper executed under Node |
| Render | Deploy to Render button | both secrets, from `render.yaml` `sync: false` | the Render service URL | image ran locally, `render.yaml` config validated only |
| Google Cloud Run | Run on Google Cloud button | both secrets, from `app.json` | the Cloud Run service URL | image ran locally, `app.json` config validated only |
| Heroku | Deploy to Heroku button | both secrets, from `app.json` | `https://<app>-<hash>.herokuapp.com` | image ran locally, `app.json` and `heroku.yml` config validated only |
| DigitalOcean App Platform | Deploy to DO button | both secrets, from `.do/deploy.template.yaml` | the App Platform URL | image ran locally, template config validated only |
| AWS Lambda | CloudFormation Launch Stack, function inlined in the template | both secrets, as `NoEcho` parameters | the function URL, from the stack output | the generated inline function ran locally under Node 22 against Function URL events; template config validated only |
| Deno Deploy | New app from the repo, entrypoint `deploy/deno/main.ts` | both secrets, in the dashboard | the app's URL | ran locally in the platform's own runtime (Deno 2.9.7) |
| Supabase Edge Functions | `supabase functions deploy stop-rules` | `supabase secrets set` | `https://<ref>.functions.supabase.co/stop-rules` | ran locally in Deno, which is the runtime Supabase uses; the Supabase CLI was not available here |
| Fly.io | `fly launch` then `fly secrets set` | nothing, you set secrets by command | `https://<app>.fly.dev` | image ran locally, `fly.toml` config validated only |
| Any Docker host, VM or laptop | `docker build` then `docker run`, or `npm start`, or `stop-rules serve` | env vars you pass | wherever you publish port 8080 | ran locally (image built and served real traffic) |
| Railway | `railway up`, or a template the owner publishes | env vars you set | the Railway service URL | docs-confirmed only |
| Azure Container Apps | Deploy to Azure button, on a published image | both secrets, as `secureString` parameters | the container app FQDN | config validated only, and it needs a published image first |
### Cloudflare Workers

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/haystackeditor/stop-rules)
```

Files: `wrangler.jsonc` (entry `src/server/cloudflare.ts`) and `.dev.vars.example`, which is
what makes the button ask for the two secrets. By hand:

```bash
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put STOP_RULES_TOKEN
npx wrangler deploy
```

Measured on that deploy, 21 September 2026, with the worker's own log tailed: 8 teammates
checking at the same moment each got their answer in 1 second, and the worker logged 8
requests, all OK; 32 at the same moment each got theirs in 2 to 3 seconds, 32 requests
logged, all OK, and no client saw a 429 or a "not checked". Each teammate was a separate
repository with its own token login and its own distinct rule text, so no two asked Jev the
same question. What that run did not exercise: the server's own line of 12 open calls, since
Cloudflare spread 32 short requests without any instance reaching it, so the 429-and-retry
path is still proven only by reading it.

Two things seen on the real deploy: `/health` reported both secrets missing for a few seconds
after `secret put` returned, and was right after that; and `npx wrangler delete` refuses to run
from a script without a terminal unless `CLOUDFLARE_API_TOKEN` is set, so run it by hand.

The Worker entry module is `src/server/cloudflare.ts`, not `handler.ts`, because workerd
refuses to start a Worker whose entry module has a named export that is not a handler. That
is a real failure this was caught on, not a precaution.

### Vercel

```markdown
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhaystackeditor%2Fstop-rules&env=TYPESAFE_API_KEY,STOP_RULES_TOKEN&envDescription=Your%20Jev%20API%20key%20and%20a%20team%20token)
```

The endpoint to give `stop-rules team` is `https://<app>.vercel.app/api`. Vercel routes by
file name, so `api/health.ts` and `api/v1/systemone.ts` are the two routes and no rewrite
rule is involved. `vercel.json` sets `buildCommand` to `npm run build:server`, which is the
TypeScript compile on its own, and serves `public/`
as the site.

Unconfirmed: the button image URL `https://vercel.com/button` is the one everyone uses but
it does not appear in the documentation pages that were read.

### Netlify

```markdown
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/haystackeditor/stop-rules)
```

`netlify.toml` builds with `npm run build:server`, publishes `public/`, and lists both secrets
under `[template.environment]`, whose placeholder strings become the labels the button
shows. `netlify/functions/stop-rules.mts` declares
`config = { path: ["/health", "/v1/systemone"] }`, so those two paths go to the function and
the site root stays a static page. The endpoint to give `stop-rules team` is the site URL.

### Render

```markdown
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/haystackeditor/stop-rules)
```

`render.yaml` declares a Docker web service with `healthCheckPath: /health` and both secrets
as `sync: false`, which is what makes Render prompt for them while creating the blueprint.
It also sets `autoDeployTrigger: "off"`, so a button deploy does not redeploy itself on
every push to this repository. Add `/tree/<branch>` to the `repo` parameter for a branch.

### Google Cloud Run

```markdown
[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/haystackeditor/stop-rules)
```

The button builds the repository's `Dockerfile` and reads the root `app.json` for the two
prompts. Add `&revision=BRANCH` for a branch other than the default. Afterwards the service
URL is printed in Cloud Shell and shown in the Cloud Run console.

The one `app.json` is written to satisfy both this button and Heroku's, using only keys both
accept. See the source notes: the Cloud Run button rejects unknown keys but deliberately
accepts Heroku's `description`, `keywords`, `logo`, `repository`, `website`, `stack` and
`formation`.

### Heroku

```markdown
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://www.heroku.com/deploy?template=https://github.com/haystackeditor/stop-rules)
```

Root `app.json` provides the two prompts and sets `"stack": "container"`, so Heroku builds
`heroku.yml`, which builds the same `Dockerfile`. Heroku sets `$PORT` itself. Buttons do not
work on Heroku's Fir generation.

### DigitalOcean App Platform

```markdown
[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/haystackeditor/stop-rules/tree/main)
```

`.do/deploy.template.yaml` keeps the app spec under a top level `spec:` key, which the
button requires. The two env vars are declared with `type: SECRET` and **no** value, which
is what makes App Platform prompt for them. The deploy button supports public repositories
only.

### AWS Lambda

`deploy/aws/template.yaml` carries the whole proxy inline, so there is nothing to build,
upload or host. It creates a Lambda function on `nodejs22.x`, a function URL with
`AuthType: NONE`, and the two `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`
permissions a public function URL now needs. Both secrets are `NoEcho` parameters.

```
https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=<public https url to deploy/aws/template.yaml>&stackName=stop-rules
```

The stack output `Endpoint` is the URL to give `stop-rules team`. Secrets cannot be
prefilled in that link: CloudFormation ignores `param_` values for `NoEcho` parameters on
purpose, so the two boxes are filled in by hand in the console.

The inline code is generated, never hand written:

```bash
npm run compile        # compiles, bundles, and checks that the template below is current
npm run build:aws      # rewrite deploy/aws/template.yaml after changing the server
```

Unconfirmed: whether the console accepts a `raw.githubusercontent.com` URL as
`templateURL`. The documentation only says it takes the URL of the template, and every AWS
example uses an S3 URL, so copying `template.yaml` into a public S3 bucket is the safe way
to publish the link.

### Deno Deploy

Create an app from the repository and set the entrypoint to `deploy/deno/main.ts`. There is
no build step: Deno runs the TypeScript directly. Set both secrets as environment variables
in the dashboard. A `deno.json` is optional, so this repository does not ship one.

### Supabase Edge Functions

```bash
supabase secrets set TYPESAFE_API_KEY=... STOP_RULES_TOKEN=...
supabase functions deploy stop-rules
```

`supabase/config.toml` sets `verify_jwt = false` for this function, because it
authenticates with your team token rather than a Supabase JWT. The function strips its own
`/functions/v1/stop-rules` mount prefix, so the endpoint to give `stop-rules team` is the
function's own URL.

### Fly.io

```bash
fly launch                      # rewrites app and primary_region in fly.toml for you
fly secrets set TYPESAFE_API_KEY=... STOP_RULES_TOKEN=...
fly deploy
```

`fly.toml` builds the `Dockerfile`, serves `internal_port = 8080`, forces HTTPS and health
checks `/health`. Fly has no deploy button: its documented path is the CLI.

### Any Docker host, VM or laptop

```bash
docker build -t stop-rules .
docker run -p 8080:8080 \
  -e TYPESAFE_API_KEY=... -e STOP_RULES_TOKEN=... stop-rules
```

Or with Node 20 or newer and no container:

```bash
npm ci && npm run build:server
TYPESAFE_API_KEY=... STOP_RULES_TOKEN=... npm start        # or: stop-rules serve --port 8080
```

The image is `node:22-alpine`, listens on `$PORT` (default 8080) and binds `0.0.0.0`.

### Railway

Railway's deploy button needs a template that the repository owner publishes from the
Railway dashboard first, at `https://railway.com/new/template/<code>`. That is an owner
action and this repository does not fake it. Until then:

```bash
railway up                      # Railway builds the Dockerfile it finds at the root
```

Then set both variables on the service. This repository ships no `railway.json`, because
Railway's config as code is deprecated and new services cannot opt into it.

### Azure Container Apps

Azure has no one click path that builds a repository's Dockerfile, so this template runs an
already published image. Publishing `ghcr.io/haystackeditor/stop-rules:latest` from this
repository's `Dockerfile` is an owner action. After that:

```markdown
[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fhaystackeditor%2Fstop-rules%2Fmain%2Fdeploy%2Fazure%2Fcontainer-app.json)
```

The template takes both secrets as `secureString` parameters, stores them as container app
secrets and passes them to the container by `secretRef`. The `endpoint` output is the URL to
give `stop-rules team`. The CLI alternative that does build from source is
`az containerapp up --source .`, which needs `az login` and is not a one click link.

## Source notes

One quoted line per target, from the platform's own documentation. Every URL here returned
HTTP 200 when this file was written.

- **Cloudflare, button and secrets**: "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<your git repo URL>)" and "Worker secrets can be defined in a `.dev.vars.example` or `.env.example` file with a dotenv format". <https://developers.cloudflare.com/workers/platform/deploy-buttons/>
- **Cloudflare, config file**: "As of Wrangler v3.91.0 Wrangler supports both JSON (`wrangler.json` or `wrangler.jsonc`) and TOML (`wrangler.toml`)... Cloudflare recommends using `wrangler.jsonc` for new projects." <https://developers.cloudflare.com/workers/wrangler/configuration/>
- **Cloudflare, handler shape**: "export default { async fetch(request, env, ctx) { return new Response('Hello World!'); }, };" <https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/>
- **Cloud Run, button and Dockerfile**: "To specify a git repo, add a `git_repo=URL` query parameter" and "If the repo contains a `Dockerfile`, it will be built using the `docker build` command." <https://github.com/GoogleCloudPlatform/cloud-run-button>
- **Cloud Run, why one app.json can serve both buttons**: the button's parser calls `d.DisallowUnknownFields()`, and the struct it decodes into carries "The following are unused variables that are still silently accepted for compatibility with Heroku app.json files." for `description`, `keywords`, `logo`, `repository`, `website`, `stack` and `formation`. <https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-run-button/master/cmd/cloudshell_open/appfile.go>
- **Heroku, button**: "You can't create apps on the Fir generation of the Heroku Platform with Heroku Buttons." with the documented form `https://www.heroku.com/deploy?template=https://github.com/heroku/nodejs-getting-started`. <https://devcenter.heroku.com/articles/heroku-button>
- **Heroku, the env prompts**: of an `env` entry, "description: a human-friendly blurb about what the value is for and how to determine what it should be" and "required: A boolean indicating whether the given value is required for the app to function (default: true)". Both keys mean the same thing to the Cloud Run button, which is why one `app.json` can carry both. <https://devcenter.heroku.com/articles/app-json-schema>
- **Heroku, container build**: "If you don't include a run section, Heroku uses the CMD specified in the Dockerfile." <https://devcenter.heroku.com/articles/build-docker-images-heroku-yml>
- **Render, button**: "It's strongly recommended that you append a repo query string parameter to the button's target URL... Set the value of repo to the full https:// URL for your Git repo." <https://render.com/docs/deploy-to-render>
- **Render, blueprint keys**: "sync: false # Prompt for a value in the Render Dashboard", and of `runtime`: "This field replaces the deprecated env field." <https://render.com/docs/blueprint-spec>
- **DigitalOcean, template shape**: "The YAML file has the same structure as a regular app spec, but the spec information goes under a spec: key. If you leave out the spec: key, the button does not work." <https://docs.digitalocean.com/products/app-platform/how-to/add-deploy-do-button/>
- **DigitalOcean, Dockerfile builds**: "dockerfile_path - String. The path to the Dockerfile relative to the root of the repo. If set, it will be used to build this component." <https://docs.digitalocean.com/products/app-platform/reference/app-spec/>
- **Netlify, button**: "The URL the button takes users to: `https://app.netlify.com/start/deploy`. This link requires the public Git repository as a parameter, for example: `https://app.netlify.com/start/deploy?repository=https://github.com/netlify/netlify-statuskit`" <https://docs.netlify.com/deploy/create-deploys/>
- **Netlify, function routing**: "`path` supports the web platform `URLPattern` syntax for wildcards and named groups." <https://docs.netlify.com/build/functions/configuration/>
- **Netlify, env vars in functions**: "you can access them in your serverless functions using the format `process.env.VARIABLE_NAME`". `Netlify.env.get` belongs to Edge Functions, not to these. <https://docs.netlify.com/build/functions/environment-variables/>
- **Vercel, button parameters**: "`env` (`string[]`) - A comma-separated list of required environment variable keys." <https://vercel.com/docs/deploy-button/environment-variables>
- **Vercel, handler shape**: "Vercel Functions also support the `fetch` Web Standard export... It uses the Web Handlers syntax and allows you to handle all HTTP methods inside a single function.", with the example `export default { fetch(request: Request) { ... } }` in `api/hello.ts`. <https://vercel.com/docs/functions/functions-api-reference>
- **AWS, inline code limit**: "If you include your function source inline with this parameter, AWS CloudFormation places it in a file named `index` and zips it to create a deployment package. This zip file cannot exceed 4MB. For the `Handler` property, the first part of the handler identifier must be `index`." The earlier note that this limit was 4096 bytes was wrong. <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html>
- **AWS, event format**: "The request and response event formats follow the same schema as the Amazon API Gateway payload format version 2.0." <https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html>
- **AWS, public function URL permissions**: "Starting in October 2025, new function URLs will require both lambda:InvokeFunctionUrl and lambda:InvokeFunction permissions." <https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html>
- **AWS, quick create link**: "CloudFormation ignores parameters that don't exist in the template, and any parameters defined with their `NoEcho` property set to `true`". <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html>
- **AWS, masking secrets**: "If you set the `NoEcho` attribute to `true`, CloudFormation returns the parameter value masked as asterisks". <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html>
- **Azure, button**: "Each link starts with the same base URL: `https://portal.azure.com/#create/Microsoft.Template/uri/` Add your URL-encoded template link to the end of the base URL." The page's own example uses a `raw.githubusercontent.com` template. <https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-to-azure-button>
- **Azure, secret parameters**: "You can mark string or object parameters as secure. The value of a secure parameter isn't saved to the deployment history and isn't logged." <https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/parameters>
- **Azure, building from source needs the CLI**: "The command can build and push a container image to Azure Container Registry when you provide local source code or a GitHub repository... A Dockerfile is required to build the image". <https://learn.microsoft.com/en-us/azure/container-apps/containerapp-up>
- **Fly.io, config**: "`internal_port`: The port this service... will use... The default is 8080." <https://fly.io/docs/reference/configuration/>
- **Fly.io, secrets**: "Set one or more encrypted secrets for an application", `fly secrets set [flags] NAME=VALUE`. <https://fly.io/docs/flyctl/secrets-set/>
- **Railway, button needs a published template**: "The button is located at https://railway.com/button.svg", used as `https://railway.com/new/template/<code>`. <https://docs.railway.com/templates/publish-and-share>
- **Railway, no config file to ship**: "Config as Code is deprecated... New services cannot opt into Config as Code." <https://docs.railway.com/config-as-code>
- **Deno, entry point**: "Deno.serve((_req) => { return new Response(\"Hello, World!\"); });" <https://docs.deno.com/runtime/fundamentals/http_server>
- **Deno Deploy, config is optional**: "There are two places you can set app configuration: In source code: Using a `deno.json` or `deno.jsonc` file... In the Deno Deploy dashboard". <https://docs.deno.com/deploy/reference/builds>
- **Supabase, file layout**: "This creates a new function at `supabase/functions/hello-world/index.ts`". <https://supabase.com/docs/guides/functions/quickstart>
- **Supabase, turning JWT checks off**: "[functions.stripe-webhook]\nverify_jwt = false", for "functions that are called without an `Authorization` header, such as webhooks from external providers, or service-to-service calls that authenticate with an API key". <https://supabase.com/docs/guides/functions/auth-headers>
- **Supabase, secrets**: `supabase secrets set STRIPE_SECRET_KEY=sk_live_...`, read with `Deno.env.get('NAME_OF_SECRET')`. <https://supabase.com/docs/guides/functions/secrets>

## What the server never does

It never returns the Jev key or the team token, in a body, a header or a log line. Error
messages are passed through a redaction step that replaces either secret with `[redacted]`
before it can be returned. `GET /health` reports only the names of missing variables. The
token comparison hashes both sides with SHA-256 and compares the digests byte by byte with
no early exit.
