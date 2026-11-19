# syntax=docker/dockerfile:1
# Demo webhook receiver: zero dependencies, so no npm install at all.
# Build from the repository root:  docker build -f mock-consumer/Dockerfile .
FROM node:24-alpine
WORKDIR /app
COPY mock-consumer/package.json ./
COPY mock-consumer/src ./src
ENV MOCK_HOST=0.0.0.0 MOCK_PORT=4000
USER node
EXPOSE 4000
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "src/index.js"]
