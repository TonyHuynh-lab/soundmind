FROM node:22-alpine AS client-builder
WORKDIR /build/client
COPY client/package*.json ./
RUN npm install
COPY client/ .
RUN npm run build

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ml-service/requirements.txt ./ml-service/
RUN pip install --no-cache-dir -r ml-service/requirements.txt supervisor

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

COPY server/ ./server/
COPY ml-service/main.py ml-service/train_mf.py ./ml-service/
COPY ml-service/artifacts/ ./ml-service/artifacts/
COPY ml-service/dataset.csv ./ml-service/

COPY --from=client-builder /build/client/dist ./client/dist

COPY supervisord.conf /etc/supervisord.conf
RUN mkdir -p /app/logs

EXPOSE 5000

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
