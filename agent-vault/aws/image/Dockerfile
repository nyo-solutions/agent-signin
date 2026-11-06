# Vaultwarden served from AWS Lambda via the Lambda Web Adapter.
FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS lwa
FROM vaultwarden/server:1.37.5
COPY --from=lwa /lambda-adapter /opt/extensions/lambda-adapter
# Lambda's filesystem is read-only except /tmp; all state lives on EFS (/mnt/vw).
ENV DATA_FOLDER=/mnt/vw \
    ROCKET_ADDRESS=0.0.0.0 \
    ROCKET_PORT=8080 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/alive \
    AWS_LWA_ASYNC_INIT=true
