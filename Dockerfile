FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN mkdir -p data
ENV PORT=8080 HOST=0.0.0.0 GAME_ONLY_MODE=0
EXPOSE 8080
CMD ["node", "server.mjs"]
