FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]