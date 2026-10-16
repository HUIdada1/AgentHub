# AgentHub 反代网关 Docker 镜像（headless 形态）
#
# 构建（在仓库根执行，build context = 仓库根）：
#   docker build -f gateway/Dockerfile -t agenthub-gateway .
# 运行：docker compose -f gateway/docker-compose.yml up -d
#
# 排除规则在仓库根 .dockerignore（build context 是仓库根，gateway/ 下的同名文件对它无效）

# 国内网络直连 registry.npmjs.org 构建时常 ETIMEDOUT，可传参换镜像源：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com ...
ARG NPM_REGISTRY=https://registry.npmjs.org

# ── 依赖层（仅依赖清单变更时重建）──────────────────────────
FROM node:22.22.0-bookworm-slim AS deps
# 锁 patch 版：node:sqlite 自 Node 22.5.0 提供，浮动 tag 会漂移到不满足的版本（容器启动即崩）
ARG NPM_REGISTRY
WORKDIR /app
# 不带通配符：lock 缺失时在此直接报错，比 npm ci 阶段失败更早、原因更清晰
COPY gateway/package.json gateway/package-lock.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci --omit=dev

# ── UI 构建层（vite 单入口；产物由网关同源托管，base "./" 相对路径已适配）──────
FROM node:22.22.0-bookworm-slim AS ui
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts 跳过 electron 等 postinstall（几百 MB 二进制，构建前端用不到）
RUN npm config set registry ${NPM_REGISTRY} && npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
RUN npx vite build

# ── 运行时 ────────────────────────────────────────────────
FROM node:22.22.0-bookworm-slim

# tzdata：TZ 生效（签到时刻与日额度重置都按本地时间）；curl：HEALTHCHECK；tini：PID 1 信号转发
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tzdata tini \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# electron/ 整目录：静态闭包 105 个文件横跨 proxy 与 backend 根（24 个用量适配器、
# sqlcipher 链、config/sync 等），白名单会随新增渠道与模块持续漂移；整目录约 2.7MB，
# 换「以后新增依赖零改动」
COPY electron/backend ./electron/backend
COPY gateway/src ./gateway/src
COPY package.json ./

# Web UI 产物（入口的 UI_DIR 默认 gateway/public；缺失时入口明确跳过静态托管，只提供 API）
COPY --from=ui /app/dist ./gateway/public

ENV AGENTHUB_DATA_DIR=/data \
    AGENTHUB_HOST=0.0.0.0 \
    AGENTHUB_PROXY_PORT=9527 \
    AGENTHUB_ADMIN_PORT=9528

EXPOSE 9527 9528

# 不声明 VOLUME：与 compose bind mount 并用会产生「匿名卷幻影」（数据落在匿名卷而非宿主目录）
RUN mkdir -p /data && chown node:node /data
USER node

# 健康检查指向进程存活（/api/livez 恒 200）；
# 业务就绪度（有在线账号）走 /api/readyz，不参与容器健康判定——空池是合法状态
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${AGENTHUB_ADMIN_PORT}/api/livez" || exit 1

# 入口在 /app/gateway/src/index.cjs（入口内 PROJECT_ROOT 取其上两级 = /app）
ENTRYPOINT ["/usr/bin/tini", "--", "node", "gateway/src/index.cjs"]
