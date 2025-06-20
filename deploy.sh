#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Configuration variables
IMAGE_NAME="webrtc-server"
CONTAINER_NAME="my-webrtc-app"
PORT_MAPPING="15544:8080"

# Color codes for better output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}--- [Step 1/5] Pulling latest changes...${NC}"
git pull
echo -e "${GREEN}✅ Git pull complete.${NC}\n"

echo -e "${BLUE}--- [Step 2/5] Building Docker image...${NC}"
docker build -t ${IMAGE_NAME} .
echo -e "${GREEN}✅ Docker image built successfully.${NC}\n"

echo -e "${BLUE}--- [Step 3/5] Checking for existing container...${NC}"
# Check if container is running
if docker ps -q -f name=${CONTAINER_NAME} | grep -q .; then
    echo "Found running container. Stopping..."
    docker stop ${CONTAINER_NAME}
    echo -e "${GREEN}✅ Container stopped.${NC}"
fi

# Check if container exists (stopped)
if docker ps -aq -f name=${CONTAINER_NAME} | grep -q .; then
    echo "Found existing container. Removing..."
    docker rm ${CONTAINER_NAME}
    echo -e "${GREEN}✅ Container removed.${NC}"
fi
echo ""

echo -e "${BLUE}--- [Step 4/5] Starting new container...${NC}"
docker run -d -p ${PORT_MAPPING} --restart always --name ${CONTAINER_NAME} ${IMAGE_NAME}
echo -e "${GREEN}✅ New container started successfully.${NC}\n"

echo -e "${BLUE}--- [Step 5/5] Cleaning up dangling images...${NC}"
docker image prune -f
echo -e "${GREEN}✅ Cleanup complete.${NC}\n"

echo -e "${GREEN}🚀 Deployment finished successfully!${NC}"
echo -e "Container '${CONTAINER_NAME}' is now running with port mapping ${PORT_MAPPING}"