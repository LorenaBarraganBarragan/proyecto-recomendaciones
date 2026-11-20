FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

ENV API_PROXY_TARGET=http://backend:4000

EXPOSE 5173

CMD ["npm", "run", "dev"]
