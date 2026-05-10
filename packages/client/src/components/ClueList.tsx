import { useEffect, useRef } from "react";
import type { Clue } from "@crossplay/shared";
import styles from "./ClueList.module.css";

type Props = {
  title: string;
  clues: Clue[];
  activeNumber: number | null;
  secondaryNumber: number | null;
};

export function ClueList({ title, clues, activeNumber, secondaryNumber }: Props) {
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeNumber, secondaryNumber]);

  return (
    <section className={styles.section}>
      <h3 className={styles.title}>{title}</h3>
      <ol className={styles.list}>
        {clues.map((c) => {
          const active = c.number === activeNumber;
          const secondary = !active && c.number === secondaryNumber;
          const cls = [styles.item];
          if (active) cls.push(styles.active);
          else if (secondary) cls.push(styles.secondary);
          return (
            <li
              key={c.number}
              ref={active || secondary ? activeRef : null}
              className={cls.join(" ")}
            >
              <span className={styles.num}>{c.number}</span>
              <span className={styles.text}>{c.text}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
