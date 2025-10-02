e Node.js LTS
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json if exists
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all source code
COPY . .

# Expose HTTP port
EXPOSE 3069

# Set environment variables defaults
ENV BRIDGE_IP=192.168.1.69
ENV CONNECTOR_KEY=YOUR_KEY_HERE
ENV DEVICE_TIMEOUT=300000
ENV CLEANUP_INTERVAL=60000
ENV REQUEST_TIMEOUT=5000
ENV MAX_RETRIES=3
ENV LOG_LEVEL=info

# Start the application
CMD ["node", "index.js"]
