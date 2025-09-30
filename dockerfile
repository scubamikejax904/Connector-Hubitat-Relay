# Multi-stage build for smaller image
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install if no package-lock.json exists)
RUN npm install --only=production

# Final stage
FROM node:18-alpine

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose HTTP port
EXPOSE 3069
EXPOSE 32101/udp
EXPOSE 32100/udp

# Set environment variables (can be overridden)
ENV PORT=3069
ENV BRIDGE_IP=127.0.0.1
ENV CONNECTOR_KEY=""
ENV NODE_ENV=production

# Run the application
CMD ["node", "index.js"]
