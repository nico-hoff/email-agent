FROM node:26.12.1-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
ENV NODE_ENV=production
CMD ["npm","start"]
