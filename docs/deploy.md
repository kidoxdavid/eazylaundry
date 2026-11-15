# Deploying EazyLaundry (staging / single host)

`docker-compose.staging.yml` runs the real stack: **Postgres 16** (roles created from your secrets on first start) → one-shot **migrations**
(as `eazy_owner`) → **API** (as the no-bypass `eazy_app` role, plus the `eazy_worker` and `eazy_platform` roles) → **web** (nginx: SPA + `/api` proxy).
Only the web port is published; the API is reachable only through nginx. CI builds the images and runs `scripts/smoke-staging.sh` on every push.

## First deployment
```bash
cp .env.staging.example .env.staging          # replace every CHANGE_ME with `openssl rand -hex 24`
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build --wait
bash scripts/smoke-staging.sh http://localhost:8080
```
Put a TLS-terminating proxy or load balancer in front of the web port. Keep `SESSION_COOKIE_SECURE=true` (the default) behind HTTPS.
Set `PUBLIC_WEB_URL` to the public address (used in email links). Set `SMTP_URL` to send email; without it messages are recorded as *logged* and are **not delivered**.

### Create the first platform operator (Eazy Group SaaS console, `/platform`)
```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging run --rm \
  -e DATABASE_PLATFORM_URL=postgres://eazy_platform:<EAZY_PLATFORM_PASSWORD>@postgres:5432/eazylaundry \
  -e PLATFORM_ADMIN_PASSWORD='<at least 14 characters>' api \
  ./node_modules/.bin/tsx src/platform/create-admin.ts you@example.com "Your Name" platform_admin
```
It prints the authenticator URL **once**; scan it into an authenticator app. Restrict `/platform` to a VPN or IP allow-list at your proxy.

## Upgrades
`git pull && docker compose ... up -d --build`: the `migrate` service runs first; migrations are forward-only SQL applied in order.
Back up the `pgdata` volume (or use `pg_dump` as `eazy_owner`) **before** upgrading. Back up `APP_ENCRYPTION_SECRET` separately: without it stored MFA seeds and delivery codes cannot be read.

## Mapping to AWS (planned; not built or tested)
| Here | AWS |
|---|---|
| postgres container | RDS PostgreSQL 16 (run `infrastructure/docker/init-roles.sh` equivalent once, as the master user) |
| api / migrate images | ECS Fargate service + one-off migration task, images in ECR |
| web image | ECS Fargate behind an ALB (or S3 + CloudFront for the static files and an `/api` behaviour) |
| `.env.staging` | Secrets Manager / SSM Parameter Store injected into the task definition |
| TLS | ACM certificate on the ALB; set nginx `set_real_ip_from` to the VPC range (see the comment in `nginx.conf`) |

## Known gaps (honest list)
- No Terraform/IaC yet and nothing here has been deployed to a cloud account; only the compose stack is exercised (in CI).
- The API runs TypeScript through `tsx` (staging-grade). A compiled build with a smaller image is a later hardening step.
- Role passwords are applied only when the Postgres volume is first created; rotating them later is a manual `ALTER ROLE` plus an env change.
- Single host, no automated backups, no log shipping or metrics/alerting, no zero-downtime rollout.
- Behind a load balancer, per-IP login throttling sees the balancer's address until `set_real_ip_from` is configured.
- The Content-Security-Policy allows Google Fonts; self-host the font to remove that dependency.
