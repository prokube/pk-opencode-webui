IMAGE ?= europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/adk-coding-workflow
TAG ?= prototype-cg-20260804-161155
KUBECONFIG ?= $(HOME)/.kube/solid-crocodile.yaml
NAMESPACE ?= experiments

.PHONY: build push deploy smoke test

build:
	docker build --platform linux/amd64 -t $(IMAGE):$(TAG) .

push:
	docker push $(IMAGE):$(TAG)

deploy:
	kubectl --kubeconfig "$(KUBECONFIG)" apply -n "$(NAMESPACE)" -f deploy/workflow-template.yaml

smoke:
	kubectl --kubeconfig "$(KUBECONFIG)" create -n "$(NAMESPACE)" -f deploy/smoke-workflow.yaml

test:
	bun test
	bun run typecheck
	bun audit
