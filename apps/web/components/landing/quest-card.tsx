"use client";

import { Clock3, Layers, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { Card, CardContent } from "../ui/card";

type QuestCardProps = {
  title: string;
  tokenReward: string;
  chain: string;
  difficulty: "Easy" | "Medium" | "Hard";
  estimate: string;
};

export function QuestCard({ title, tokenReward, chain, difficulty, estimate }: QuestCardProps) {
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 320, damping: 22 }}>
      <Card className="group border-border/70 bg-card/90 transition-all duration-300 hover:shadow-xl">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-base font-semibold leading-snug text-foreground">{title}</h3>
            <span className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">{chain}</span>
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary/70 px-2.5 py-1 font-medium text-secondary-foreground">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {tokenReward}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              {difficulty}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              {estimate}
            </span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
