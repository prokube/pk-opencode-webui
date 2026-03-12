# OpenCode Web - Kubeflow Docker Build
# =====================================

IMAGE_NAME ?= opencode-web-kubeflow
IMAGE_TAG ?= latest
PLATFORM ?= linux/amd64

# Build args
S6_OVERLAY_VERSION ?= 3.1.6.2
KF_EXAMPLES_REPO ?=

# OpenCode source build args
# Set OPENCODE_BUILD_FROM_SOURCE=false to use upstream installer instead
OPENCODE_BUILD_FROM_SOURCE ?= true
OPENCODE_REPO ?= https://github.com/binarydoubling/opencode.git
OPENCODE_REF ?= fix/memory-leaks
OPENCODE_VERSION ?= 1.2.6

# Registry (optional)
REGISTRY ?=

.PHONY: build build-no-cache build-upstream run run-with-prefix stop logs shell clean help

# Build the Docker image
build:
	@echo "Building $(IMAGE_NAME):$(IMAGE_TAG)..."
	@echo "  OpenCode source: $(if $(filter true,$(OPENCODE_BUILD_FROM_SOURCE)),$(OPENCODE_REPO)@$(OPENCODE_REF),upstream installer v$(OPENCODE_VERSION))"
	cd ../.. && docker build \
		--platform $(PLATFORM) \
		-t $(IMAGE_NAME):$(IMAGE_TAG) \
		-f docker/kubeflow/Dockerfile \
		--build-arg S6_OVERLAY_VERSION=$(S6_OVERLAY_VERSION) \
		--build-arg KF_EXAMPLES_REPO=$(KF_EXAMPLES_REPO) \
		--build-arg OPENCODE_BUILD_FROM_SOURCE=$(OPENCODE_BUILD_FROM_SOURCE) \
		--build-arg OPENCODE_REPO=$(OPENCODE_REPO) \
		--build-arg OPENCODE_REF=$(OPENCODE_REF) \
		--build-arg OPENCODE_VERSION=$(OPENCODE_VERSION) \
		.

# Build without cache
build-no-cache:
	@echo "Building $(IMAGE_NAME):$(IMAGE_TAG) (no cache)..."
	@echo "  OpenCode source: $(if $(filter true,$(OPENCODE_BUILD_FROM_SOURCE)),$(OPENCODE_REPO)@$(OPENCODE_REF),upstream installer v$(OPENCODE_VERSION))"
	cd ../.. && docker build \
		--platform $(PLATFORM) \
		--no-cache \
		-t $(IMAGE_NAME):$(IMAGE_TAG) \
		-f docker/kubeflow/Dockerfile \
		--build-arg S6_OVERLAY_VERSION=$(S6_OVERLAY_VERSION) \
		--build-arg KF_EXAMPLES_REPO=$(KF_EXAMPLES_REPO) \
		--build-arg OPENCODE_BUILD_FROM_SOURCE=$(OPENCODE_BUILD_FROM_SOURCE) \
		--build-arg OPENCODE_REPO=$(OPENCODE_REPO) \
		--build-arg OPENCODE_REF=$(OPENCODE_REF) \
		--build-arg OPENCODE_VERSION=$(OPENCODE_VERSION) \
		.

# Build using upstream installer (shortcut)
build-upstream:
	@echo "Building $(IMAGE_NAME):$(IMAGE_TAG) with upstream OpenCode v$(OPENCODE_VERSION)..."
	$(MAKE) build OPENCODE_BUILD_FROM_SOURCE=false

# Run locally without prefix
run:
	@echo "Running $(IMAGE_NAME):$(IMAGE_TAG) on http://localhost:8888/"
	docker run --rm -it \
		-p 8888:8888 \
		--name opencode-web \
		$(IMAGE_NAME):$(IMAGE_TAG)

# Run with NB_PREFIX (simulating Kubeflow)
run-with-prefix:
	@echo "Running $(IMAGE_NAME):$(IMAGE_TAG) on http://localhost:8888/notebook/user/opencode/"
	docker run --rm -it \
		-p 8888:8888 \
		-e NB_PREFIX=/notebook/user/opencode/ \
		--name opencode-web \
		$(IMAGE_NAME):$(IMAGE_TAG)

# Stop running container
stop:
	docker stop opencode-web 2>/dev/null || true

# View logs
logs:
	docker logs -f opencode-web

# Shell into running container
shell:
	docker exec -it opencode-web /bin/bash

# Clean up images
clean:
	docker rmi $(IMAGE_NAME):$(IMAGE_TAG) 2>/dev/null || true

# Tag and push to registry
push:
	@if [ -z "$(REGISTRY)" ]; then \
		echo "ERROR: REGISTRY not set. Use: make push REGISTRY=your-registry.com/path"; \
		exit 1; \
	fi
	docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)

# Help
help:
	@echo "OpenCode Web - Kubeflow Docker Build"
	@echo ""
	@echo "Usage:"
	@echo "  make build              Build with memory-leak fix fork (default)"
	@echo "  make build-upstream     Build with upstream OpenCode installer"
	@echo "  make build-no-cache     Build without Docker cache"
	@echo "  make run                Run locally (http://localhost:8888/)"
	@echo "  make run-with-prefix    Run with NB_PREFIX simulation"
	@echo "  make stop               Stop running container"
	@echo "  make logs               View container logs"
	@echo "  make shell              Shell into container"
	@echo "  make clean              Remove built image"
	@echo "  make push               Push to registry (set REGISTRY=...)"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE_NAME=$(IMAGE_NAME)"
	@echo "  IMAGE_TAG=$(IMAGE_TAG)"
	@echo "  PLATFORM=$(PLATFORM)"
	@echo "  REGISTRY=$(REGISTRY)"
	@echo ""
	@echo "OpenCode source:"
	@echo "  OPENCODE_BUILD_FROM_SOURCE=$(OPENCODE_BUILD_FROM_SOURCE)"
	@echo "  OPENCODE_REPO=$(OPENCODE_REPO)"
	@echo "  OPENCODE_REF=$(OPENCODE_REF)"
	@echo "  OPENCODE_VERSION=$(OPENCODE_VERSION) (used when BUILD_FROM_SOURCE=false)"
