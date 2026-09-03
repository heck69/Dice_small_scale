require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createServiceClient } = require('../lib/supabase');
const { mapImportItem } = require('./map-client-record');

async function loadRecords() {
  const apiUrl = process.env.CLIENTS_API_URL;
  if (apiUrl) {
    const headers = { Accept: 'application/json' };
    if (process.env.CLIENTS_API_TOKEN) {
      headers.Authorization = `Bearer ${process.env.CLIENTS_API_TOKEN}`;
    }
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      throw new Error(`CLIENTS_API_URL failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.records)) return payload.records;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.client) return [payload];
    throw new Error('API response was not an array of client records.');
  }

  const filePath = process.argv[2] || path.join('data', 'sample-clients.json');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Import file not found: ${resolved}`);
  }
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (Array.isArray(payload)) return payload;
  if (payload.client) return [payload];
  throw new Error('JSON file must be an array of { client, additional_information } records.');
}

async function importRecords(records) {
  const supabase = createServiceClient();
  let imported = 0;
  let failed = 0;

  for (const [index, item] of records.entries()) {
    let applywizzId = `row ${index + 1}`;
    try {
      const { clientRow, profileRow } = mapImportItem(item);
      applywizzId = clientRow.applywizz_id;

      const { error: clientError } = await supabase
        .from('clients')
        .upsert(clientRow, { onConflict: 'id' });
      if (clientError) throw clientError;

      if (profileRow) {
        const { error: profileError } = await supabase
          .from('client_profiles')
          .upsert(profileRow, { onConflict: 'id' });
        if (profileError) throw profileError;
      }

      imported += 1;
      console.log(`[ok] ${applywizzId} (${clientRow.company_email})`);
    } catch (error) {
      failed += 1;
      console.error(`[fail] ${applywizzId}: ${error.message}`);
    }
  }

  console.log(`Import finished. imported=${imported} failed=${failed} total=${records.length}`);
  if (failed > 0 && imported === 0) process.exit(1);
}

loadRecords()
  .then(importRecords)
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
