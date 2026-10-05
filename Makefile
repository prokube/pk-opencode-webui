REGISTRY ?= europe-west3-docker.pkg.dev/prokube-internal/prokube-customer
IMAGE_TAG ?= browser-session-dev
IMAGE := $(REGISTRY)/pk-opencode-webui:$(IMAGE_TAG)

.PHONY: build-notebook push-notebook
build-notebook:
	docker build --platform linux/amd64 --build-arg BUN_VERSION=1.3.9 -f docker/kubeflow/Dockerfile -t $(IMAGE) .

push-notebook:
	docker push $(IMAGE)
