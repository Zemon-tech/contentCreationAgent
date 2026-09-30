/**
 * Lead research CLI (runs the same workflow Studio runs, without the server).
 *
 *   npm run leads -- run --file ./data/startups.csv [--batch-id X] [--refresh] [--max-rows 10]
 *   npm run leads -- status <batchId>
 *   npm run leads -- export <batchId>
 *   npm run leads -- delete <rowId> [--exa]      (privacy: delete a row's data; --exa also deletes stored Exa runs)
 *
 * Safe to interrupt: everything already researched is in the lead store.
 * Re-run the same command to resume (completed modules are not paid for again).
 */
import Exa from "exa-js";
import { loadLeadConfig, LeadConfigError } from "../config/leadConfig";
import { closeLeadDb, createLeadStore, currentLeadDbUrl } from "../repositories/leadStore";
import { writeBatchExports } from "../lib/leads/exporters";
import { leadQualificationWorkflow } from "../workflows/leadQualificationWorkflow";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadLeadConfig();
  const store = createLeadStore(config.databaseUrl, config.databaseAuthToken);

  switch (cmd) {
    case "run": {
      const file = arg(args, "--file");
      if (!file) throw new Error("run requires --file <path.csv>");
      const maxRows = arg(args, "--max-rows");
      process.on("SIGINT", () => {
        console.error("\nInterrupted. Research done so far is saved; run the same command again to resume.");
        process.exit(130);
      });
      const run = await leadQualificationWorkflow.createRun();
      const result = await run.start({
        inputData: {
          csvPath: file,
          batchId: arg(args, "--batch-id"),
          refresh: args.includes("--refresh"),
          ...(maxRows ? { maxRows: Number(maxRows) } : {}),
        },
      });
      if (result.status !== "success") {
        const err = (result as { error?: unknown }).error;
        console.error(`Workflow ${result.status}: ${err instanceof Error ? err.message : JSON.stringify(err ?? "")}`);
        return 1;
      }
      const out = result.result;
      console.log(out.summary);
      console.log(`\nExports: ${out.exportsDir ?? "(export failed; run: npm run leads -- export " + out.batchId + ")"}`);
      return out.status === "completed" ? 0 : 2;
    }
    case "status": {
      const batchId = args[0];
      if (!batchId) throw new Error("status requires <batchId>");
      const batch = await store.getBatch(batchId);
      if (!batch) throw new Error(`batch ${batchId} not found in ${currentLeadDbUrl()}`);
      const rows = await store.listRows(batchId);
      const byStatus: Record<string, number> = {};
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      console.log(JSON.stringify({ batch: { ...batch, config_snapshot: undefined }, rows: byStatus, spentUsd: await store.sumBatchCost(batchId) }, null, 2));
      return 0;
    }
    case "export": {
      const batchId = args[0];
      if (!batchId) throw new Error("export requires <batchId>");
      if (!(await store.getBatch(batchId))) throw new Error(`batch ${batchId} not found`);
      const exp = await writeBatchExports(store, batchId, config.exportDir);
      console.log(exp.summary);
      console.log(`\nExports: ${exp.dir}`);
      return 0;
    }
    case "delete": {
      const rowId = args[0];
      if (!rowId) throw new Error("delete requires <rowId>");
      const res = await store.deleteRow(rowId);
      console.log(`Deleted row ${rowId}: ${res.moduleRuns} module runs, ${res.companies} company records, ${res.rows} batch rows.`);
      if (args.includes("--exa") && res.runIds.length) {
        const exa = new Exa(config.exaApiKey);
        let ok = 0;
        for (const id of res.runIds) {
          try {
            await exa.agent.runs.delete(id);
            ok++;
          } catch (err) {
            console.error(`  could not delete Exa run ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        console.log(`Deleted ${ok}/${res.runIds.length} stored Exa runs.`);
      }
      console.log("Note: files already exported under LEAD_EXPORT_DIR are not modified; re-export or delete them.");
      return 0;
    }
    default:
      console.log("Usage: npm run leads -- <run --file x.csv [--batch-id id] [--refresh] [--max-rows n] | status <batchId> | export <batchId> | delete <rowId> [--exa]>");
      return cmd ? 1 : 0;
  }
}

main()
  .then((code) => {
    closeLeadDb();
    process.exit(code);
  })
  .catch((err) => {
    closeLeadDb();
    console.error(err instanceof LeadConfigError ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
