FROM node:22-alpine

WORKDIR /app
COPY . .
RUN npm install --omit=dev

EXPOSE 3003
CMD ["node", "services/alerting/src/server.js"]
