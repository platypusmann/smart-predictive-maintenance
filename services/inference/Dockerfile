FROM node:22-alpine

WORKDIR /app
# copies ml/artifacts/model.json in too
COPY . .
RUN npm install --omit=dev

EXPOSE 3002
CMD ["node", "services/inference/src/server.js"]
