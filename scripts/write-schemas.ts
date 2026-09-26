import fs from 'node:fs';
import { SnapshotSchema } from '../src/shared/snapshot-schema.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConfigSchema, SecretsSchema, builtinSchemas } from '../src/server/config.js';
import { CheckResultSchema, DiagnosticSectionSchema } from '../src/shared/contracts.js';
fs.mkdirSync('config', { recursive: true });
for (const [name, schema] of Object.entries({ snapshot: SnapshotSchema, config: ConfigSchema, secrets: SecretsSchema, 'check-result': CheckResultSchema, 'diagnostic-section': DiagnosticSectionSchema, ...Object.fromEntries(Object.entries(builtinSchemas).map(([k,v]) => ['adapter-' + k, v])) })) {
  fs.writeFileSync('config/' + name + '.schema.json', JSON.stringify(zodToJsonSchema(schema, { name }), null, 2) + '\n');
}
