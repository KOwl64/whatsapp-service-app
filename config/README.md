# Auto-Send Configuration

Configuration file for automatic POD distribution based on confidence thresholds.

## File Location

```
config/auto-send.json
```

## Configuration Schema

```json
{
  "enabled": true,
  "defaultThreshold": 0.95,
  "supplierRules": { ... },
  "reviewRequired": { ... },
  "autoRoute": { ... },
  "confidenceWeights": { ... },
  "audit": { ... }
}
```

## Configuration Options

### `enabled` (boolean)
Enable or disable auto-send rules.
- `true`: Auto-send rules are evaluated
- `false`: All attachments require manual review

### `defaultThreshold` (number, 0.0-1.0)
Default confidence threshold for suppliers not explicitly configured.
- Default: `0.95`
- Higher values = stricter (more manual review required)

### `supplierRules` (object)
Supplier-specific threshold overrides.

| Supplier | Threshold | Description |
|----------|-----------|-------------|
| `CEMEX` | 0.90 | Lower threshold for CEMEX |
| `TARMAC` | 0.92 | Lower threshold for Tarmac |
| `CPI_EUROMIX` | 0.95 | Standard threshold |
| `ECOCEM` | 0.90 | Lower threshold for Ecocem |
| `HEIDELBERG` | 0.92 | Lower threshold for Heidelberg |
| `SMARTFLOW` | 0.95 | Standard threshold |
| `*` | (uses defaultThreshold) | Wildcard for all other suppliers |

### `reviewRequired` (object)
Conditions that require manual review.

| Key | Type | Description |
|-----|------|-------------|
| `belowThreshold` | boolean | Flag if confidence is below threshold |
| `lowConfidence` | boolean | Flag if classification confidence is low |
| `noMatch` | boolean | Flag if no job match was found |

### `confidenceWeights` (object)
Weighting for confidence calculation.

| Component | Weight | Description |
|-----------|--------|-------------|
| `classification` | 0.25 | POD classification confidence |
| `extraction` | 0.35 | Field extraction confidence |
| `matching` | 0.40 | Job matching confidence |

**Note**: Weights must sum to 1.0

### `audit` (object)
Audit logging configuration.

| Key | Type | Description |
|-----|------|-------------|
| `logDecisions` | boolean | Enable decision logging |
| `logReasonCodes` | array | Reason codes to log |

## Decision Types

| Decision | Description | Next Action |
|----------|-------------|-------------|
| `AUTO_SEND` | High confidence - auto approve | `READY_FOR_EXPORT` |
| `MANUAL_REVIEW` | Below threshold - needs review | `REVIEW` |
| `FORCE_SEND` | Manual override | `READY_FOR_EXPORT` |
| `REJECT` | Manual rejection | `REJECTED` |

## Confidence Calculation

Overall confidence is calculated as:

```
overall = (classification * 0.25) + (extraction * 0.35) + (matching * 0.40)
```

## API Endpoints

### GET /api/auto-send/config
Get current auto-send configuration summary.

### POST /api/auto-send/reload
Reload configuration from file.

### POST /api/auto-send/validate
Validate configuration file syntax.

### POST /api/auto-send/simulate
Simulate auto-send decision for an attachment.

## Manual Review Endpoints

### POST /api/attachments/:id/approve
Approve attachment for export (moves from REVIEW to OUT).

### POST /api/attachments/:id/reject
Reject attachment (moves to QUARANTINE).

### POST /api/attachments/:id/force-send
Force send attachment regardless of confidence threshold.

## Example Usage

### High confidence POD (auto-sends)
- Classification: 0.95
- Extraction: 0.98
- Matching: 0.97
- Overall: 0.9675 (above 0.95 threshold)
- Decision: AUTO_SEND

### Low confidence POD (manual review)
- Classification: 0.70
- Extraction: 0.60
- Matching: 0.50
- Overall: 0.5975 (below 0.95 threshold)
- Decision: MANUAL_REVIEW

## Environment Variables

No additional environment variables required. Configuration is loaded from `config/auto-send.json`.

## Hot Reload

Configuration can be reloaded without restarting the service:

```bash
curl -X POST http://localhost:3000/api/auto-send/reload
```
