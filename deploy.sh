#!/bin/bash

# --- Configuration ---
# Exit immediately if a command exits with a non-zero status.
set -e
# Treat unset variables as an error when substituting.
set -u
# Pipestatus is non-zero if any of the commands in a pipeline fail.
set -o pipefail

# --- Script Variables ---
IMAGE_NAME="webrtc-server"
CONTAINER_NAME="my-webrtc-app"
PORT_MAPPING="15544:8080"
SCRIPT_NAME=$(basename "$0")

# --- Color Codes ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# --- Helper Functions ---
log_info() {
    echo -e "${BLUE}--- $1 ---${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}\n"
}

log_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
}

log_error() {
    echo -e "${RED}❌ ERROR: $1${NC}" >&2
    exit 1
}

# --- Main Logic ---

# 1. Git Operations
log_info "[Step 1/5] Updating source code..."

# Check if a commit hash is provided as an argument
if [ -n "${1-}" ]; then
    COMMIT_HASH=$1
    log_warning "Commit hash provided: ${COMMIT_HASH}. Resetting repository."

    # Validate if the hash exists
    if ! git cat-file -e "${COMMIT_HASH}^{commit}" 2>/dev/null; then
        log_error "Invalid or non-existent commit hash: ${COMMIT_HASH}"
    fi

    # Fetch latest updates from remote to ensure the commit is available
    git fetch origin

    # Stash any local changes to prevent data loss before reset
    if ! git diff-index --quiet HEAD --; then
        log_warning "Local changes detected. Stashing them before reset."
        git stash push -m "Auto-stash before reset by ${SCRIPT_NAME}"
    fi

    # Reset to the specified commit
    git reset --hard "${COMMIT_HASH}"
    log_success "Repository reset to ${COMMIT_HASH}."

    # This is the key part to solve the permission issue.
    # After reset, the script file itself might have its permissions changed.
    # We ensure it remains executable for future runs.
    if [ -f "${SCRIPT_NAME}" ]; then
        chmod +x "${SCRIPT_NAME}"
        log_info "Ensured ${SCRIPT_NAME} has execute permissions."
    fi

else
    log_info "No commit hash provided. Pulling latest changes from dev."
    # Ensure we are on the dev branch before pulling
    git checkout dev
    git pull origin dev
    log_success "Git pull complete."
fi


# 2. Build Docker Image
log_info "[Step 2/5] Building Docker image..."
docker build -t "${IMAGE_NAME}" .
log_success "Docker image built successfully."

# 3. Stop and Remove Existing Container
log_info "[Step 3/5] Checking for existing container..."
# Use a more robust check and silence grep's output
if [ "$(docker ps -q -f name=^/${CONTAINER_NAME}$)" ]; then
    log_info "Found running container. Stopping..."
    docker stop "${CONTAINER_NAME}"
    log_success "Container stopped."
fi

if [ "$(docker ps -aq -f name=^/${CONTAINER_NAME}$)" ]; then
    log_info "Found existing container. Removing..."
    docker rm "${CONTAINER_NAME}"
    log_success "Container removed."
fi

# 4. Start New Container
log_info "[Step 4/5] Starting new container..."
docker run -d -p "${PORT_MAPPING}" --restart always --name "${CONTAINER_NAME}" "${IMAGE_NAME}"
log_success "New container started successfully."

# 5. Clean Up Dangling Images
log_info "[Step 5/5] Cleaning up dangling images..."
# The output of prune can be verbose, -f handles it.
docker image prune -f
log_success "Cleanup complete."

echo -e "${GREEN}🚀 Deployment finished successfully!${NC}"
echo -e "Container '${CONTAINER_NAME}' is now running with port mapping ${PORT_MAPPING}"