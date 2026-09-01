# Multi-stage Dockerfile for AniSkip Mirror.
#
# Stage 1: build a small Python "importer" image that runs scripts/.
# Stage 2: a tiny Node.js runtime for the Vercel-compatible API.
#
# In production we expect you to deploy the API to Vercel and use this
# Dockerfile only for running the importer locally or in CI. It also
# works if you'd rather self-host the API on a single box.

FROM python:3.12-slim AS importer
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY scripts/ ./scripts/
COPY sql/ ./sql/
ENTRYPOINT ["python3", "scripts/import_dataset.py"]
CMD ["--help"]


FROM node:20-slim AS api
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY api ./api
COPY vercel.json ./
EXPOSE 3000
CMD ["node", "api/_server.js"]