"use client";

import { useState } from "react";
import { ChevronDown, FileCheck2 } from "lucide-react";

const sampleReceipt = {
  questId: "quest_apex_referral_2026",
  taskId: "task_x_post_screenshot",
  evidenceHash: "0x93f8b77ffde4d9db8d9ec0df6f87f58a5fe412317f66",
  decisionHash: "0xa4c1e6fd31d42a5a3adf9e2267ed4b132bb08f0c2bb8",
  topicId: "0.0.5926017",
  sequenceNo: 31842,
  txId: "0.0.5926017@1739402507.530831167"
};

export function ReceiptViewer() {
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm sm:p-6">
      <button
        type="button"
        className="focus-ring flex w-full items-center justify-between gap-3 rounded-xl text-left"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls="receipt-panel"
      >
        <div className="flex items-center gap-2">
          <FileCheck2 className="h-5 w-5 text-primary" aria-hidden="true" />
          <span className="text-base font-semibold text-foreground">View sample receipt</span>
        </div>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open ? (
        <div id="receipt-panel" className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-muted/40 p-4 text-sm">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.entries(sampleReceipt).map(([key, value]) => (
              <div key={key} className="rounded-lg bg-card/80 p-3">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">{key}</dt>
                <dd className="mt-1 break-all font-medium text-foreground">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
