# Production Dockerfile for Microsoft Azure (Azure Container Apps / App Service)
# Includes Chromium dependencies pre-installed via official Microsoft Playwright image

FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Environment Defaults for Azure
ENV NODE_ENV=production
ENV USE_BROWSERBASE=false
ENV PORT=3001

EXPOSE 3001

# Start iMessage Orchestrator
CMD ["node", "imessage-orchestrator.js"]
