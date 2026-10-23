#!/bin/bash
set -euo pipefail

max_receive_count="${SQS_MAX_RECEIVE_COUNT:-5}"
visibility_timeout="${SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS:-60}"
if ! [[ "$max_receive_count" =~ ^[1-9][0-9]*$ ]] || (( max_receive_count > 1000 )); then
  echo "SQS_MAX_RECEIVE_COUNT must be an integer between 1 and 1000" >&2
  exit 1
fi
if ! [[ "$visibility_timeout" =~ ^[1-9][0-9]*$ ]] || (( visibility_timeout > 43200 )); then
  echo "SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS must be an integer between 1 and 43200" >&2
  exit 1
fi

dlq_url=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

main_attributes=$(python3 -c 'import json,sys; print(json.dumps({"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":sys.argv[1],"RedrivePolicy":json.dumps({"deadLetterTargetArn":sys.argv[2],"maxReceiveCount":sys.argv[3]})}))' "$visibility_timeout" "$dlq_arn" "$max_receive_count")

awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "$main_attributes"
awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

touch /tmp/sqs-ready
