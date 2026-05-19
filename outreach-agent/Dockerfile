FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY README.md ./
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

ENTRYPOINT ["node", "./dist/src/index.js"]
CMD ["--help"]
