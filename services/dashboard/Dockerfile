FROM node:22-alpine

WORKDIR /app
COPY . .
RUN npm install --omit=dev

EXPOSE 3000
CMD ["node", "services/dashboard/src/server.js"]
