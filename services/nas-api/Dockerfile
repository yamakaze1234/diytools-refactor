# 只包含业务API，不包含旧同步协议和本地业务资料。
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8080
CMD ["node","src/main.mjs"]
