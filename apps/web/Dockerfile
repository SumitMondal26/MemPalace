FROM node:20-alpine

WORKDIR /app

# Install deps first (layer cache).
COPY package.json package-lock.json* ./
RUN npm install

# App code is bind-mounted in dev, but we COPY for image-only runs.
COPY . .

ENV NODE_ENV=development
EXPOSE 3000

CMD ["npm", "run", "dev"]
