FROM node:22-alpine
ARG VCS_REF=unknown
ARG VERSION=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
LABEL org.opencontainers.image.version=$VERSION
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs README.md ./
COPY server ./server
COPY public ./public
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
