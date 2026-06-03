FROM node:20-slim

# Install ffmpeg via apt
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000
CMD node scripts/download-geoip.js ; node server.js
