# Intelisync Arbit Contracts (Foundry)

Production-oriented Foundry project scaffold with OpenZeppelin contracts integration.

## Project Structure

- `src/core`: main protocol contracts
- `src/interfaces`: interfaces and external type declarations
- `src/libraries`: internal libraries and helper code
- `src/mocks`: mock contracts for testing
- `script/deploy`: deployment scripts
- `script/ops`: operational/maintenance scripts
- `test/unit`: fast unit tests
- `test/integration`: integration-level tests
- `test/utils`: shared test fixtures and helpers
- `config`: chain and app config files
- `deployments`: deployment artifacts per network

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)

## Setup

```sh
forge install
cp .env.example .env
```

## Build

```sh
forge build
```

## Test

```sh
forge test -vv
```

## Deploy

Example deploy command for the starter `ManagedCounter` contract:

```sh
source .env
forge script script/deploy/DeployManagedCounter.s.sol:DeployManagedCounter \
  --rpc-url "$RPC_URL" \
  --broadcast
```
