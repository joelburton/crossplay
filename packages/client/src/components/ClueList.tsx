import { useEffect, useRef } from "react";
import type { Clue, Direction } from "@crossplay/shared";
import styles from "./ClueList.module.css";

type Props = {
  title: string;
  direction: Direction;
  clues: Clue[];
  activeNumber: number | null;
  secondaryNumber: number | null;
  onClueClick: (number: number, direction: Direction) => void;
};

/**
 * Scrollable clue list — one per direction. Two highlight tiers:
 *
 *   - `activeNumber`: the clue whose word the cursor is currently
 *     navigating. Rendered with the strong cursor color.
 *   - `secondaryNumber`: the cross word's number — i.e. when the
 *     cursor is on a cell going across, the down clue list shows the
 *     down word that *passes through* the cell, and vice versa.
 *     Rendered in a softer tint so the user always sees both.
 *
 * Both highlighted entries scroll into view when they change.
 */
export function ClueList({
  title,
  direction,
  clues,
  activeNumber,
  secondaryNumber,
  onClueClick,
}: Props) {
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
              onClick={() => onClueClick(c.number, direction)}
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
