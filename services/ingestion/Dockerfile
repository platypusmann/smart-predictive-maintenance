FROM node:22-alpine

WORKDIR /app
COPY . .
RUN npm install --omit=dev

EXPOSE 3001
CMD ["node", "services/ingestion/src/server.js"]
