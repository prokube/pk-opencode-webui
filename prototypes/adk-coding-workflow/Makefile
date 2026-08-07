IMAGE ?= europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/adk-coding-workflow
TAG ?= prototype-cg-20260807-1128
KUBECONFIG ?= $(HOME)/.kube/solid-crocodile.yaml
NAMESPACE ?= experiments
ISSUE ?=
BASE ?= main

.PHONY: build push deploy smoke smoke-execute publish-issue test

build:
	docker build --platform linux/amd64 -t $(IMAGE):$(TAG) .

push:
	docker push $(IMAGE):$(TAG)

deploy:
	kubectl --kubeconfig "$(KUBECONFIG)" apply -n "$(NAMESPACE)" -f deploy/workflow-template.yaml

smoke:
	kubectl --kubeconfig "$(KUBECONFIG)" create -n "$(NAMESPACE)" -f deploy/smoke-workflow.yaml

smoke-execute:
	kubectl --kubeconfig "$(KUBECONFIG)" create -n "$(NAMESPACE)" -f deploy/execute-smoke-workflow.yaml

publish-issue:
	@test -n "$(ISSUE)" || (echo "ISSUE is required" >&2; exit 2)
	@ISSUE="$(ISSUE)" BASE="$(BASE)" yq eval '(.spec.arguments.parameters[] | select(.name == "issue").value) = strenv(ISSUE) | .spec.arguments.parameters += [{"name": "base", "value": strenv(BASE)}]' deploy/publish-workflow.yaml | kubectl --kubeconfig "$(KUBECONFIG)" create -n "$(NAMESPACE)" -f -

test:
	bun test
	bun run typecheck
	bun audit
