FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
# Les migrations s'exécutent au démarrage (verrou consultatif PostgreSQL).
CMD ["node", "server/index.js"]
