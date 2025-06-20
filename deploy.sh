#!/bin/bash

# --- Configuration ---
# Exit immediately if a command exits with a non-zero status.
set -e
# Treat unset variables as an error when substituting.
set -u
# A pipeline's exit status is the value of the last command to exit with a non-zero status,
# or zero if all commands in the pipeline exit successfully.
set -o pipefail

# --- Script Variables ---
IMAGE_NAME="webrtc-server"
CONTAINER_NAME="my-webrtc-app"
PORT_MAPPING="15544:8080"
# The script's path relative to the git repository root.
# This makes it robust even if run from a subdirectory.
SCRIPT_PATH_IN_REPO="deploy.sh"

# --- Color Codes ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# --- Helper Functions ---
log_info() { echo -e "${BLUE}--- $1 ---${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}\n"; }
log_warning() { echo -e "${YELLOW}⚠️ $1${NC}"; }
log_error() { echo -e "${RED}❌ ERROR: $1${NC}" >&2; exit 1; }

# --- Pre-flight Checks ---
# Ensure we are in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    log_error "This script must be run from within a git repository."
fi

# --- Main Logic ---

# 1. Git Operations
log_info "[Step 1/5] Updating source code..."

# Universally stash any local changes to prevent errors during git operations.
# This is the key to making the script robust against local modifications.
if ! git diff-index --quiet HEAD --; then
    log_warning "Local changes detected. Stashing them to prevent data loss."
    git stash push -m "Auto-stash by deployment script"
fi

# Fetch latest updates from remote to ensure we have all commits and branches.
git fetch origin

# Check if a commit hash is provided as an argument
if [ -n "${1-}" ]; then
    COMMIT_HASH=$1
    log_warning "Commit hash provided: ${COMMIT_HASH}. Resetting repository."

    # Validate if the hash exists in the repository history
    if ! git cat-file -e "${COMMIT_HASH}^{commit}" 2>/dev/null; then
        log_error "Invalid or non-existent commit hash: ${COMMIT_HASH}"
    fi

    # Get the hash of the latest commit on the remote dev branch BEFORE resetting
    LATEST_DEV_HASH=$(git rev-parse origin/dev)

    # Reset to the specified commit
    log_info "Resetting HEAD to ${COMMIT_HASH}..."
    git reset --hard "${COMMIT_HASH}"
    log_success "Repository reset to ${COMMIT_HASH}."

    # SELF-HEALING: Restore the latest version of the deployment script from the dev branch
    log_info "Restoring latest version of the deployment script from dev branch..."
    git checkout "${LATEST_DEV_HASH}" -- "${SCRIPT_PATH_IN_REPO}"
    chmod +x "${SCRIPT_PATH_IN_REPO}"
    log_success "Deployment script restored and executable."

else
    log_info "No commit hash provided. Checking out and pulling latest changes from dev branch."
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
# Use a more robust check that matches the exact container name
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
docker image prune -f
log_success "Cleanup complete."

echo -e "${GREEN}🚀 Deployment finished successfully!${NC}"
echo -e "Container '${CONTAINER_NAME}' is now running with port mapping ${PORT_MAPPING}"