// A test-only key: a Redis world refuses to start without one (see `queueAuthKey`).
process.env.WORKFLOW_QUEUE_AUTH_KEY ??=
  "PFZaRa4dQzhgPdrVUNW-sHdEMFov59egd9dqo6Td2no";
