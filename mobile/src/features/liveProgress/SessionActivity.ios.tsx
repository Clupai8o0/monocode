import { HStack, Rectangle, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, frame, lineLimit } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity } from "expo-widgets";

export type SessionActivityProps = {
  title: string;
  project: string;
  step: string;
  startedAt: number;
  sprite: string[];
  attention: boolean;
};

/**
 * Runs in the widget extension, not the app: no hooks, nothing from outside
 * this function, and only SwiftUI views. The timer counts by itself, so it
 * stays right when the app is suspended.
 */
function SessionActivity(props: SessionActivityProps) {
  "widget";
  const tint = props.attention ? "#E5A000" : "#4C9AFF";
  const mascot = (cell: number) => (
    <VStack spacing={0}>
      {props.sprite.map((row, y) => (
        <HStack key={y} spacing={0}>
          {row.split("").map((pixel, x) => (
            <Rectangle
              key={x}
              modifiers={[
                frame({ width: cell, height: cell }),
                foregroundStyle(pixel === "#" ? tint : "#00000000"),
              ]}
            />
          ))}
        </HStack>
      ))}
    </VStack>
  );
  const timer = (
    <Text
      date={new Date(props.startedAt)}
      dateStyle="timer"
      modifiers={[
        font({ textStyle: "subheadline", design: "monospaced" }),
        frame({ width: 56 }),
      ]}
    />
  );
  return {
    banner: (
      <HStack spacing={12} modifiers={[frame({ maxWidth: Infinity })]}>
        {mascot(4)}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: "headline" }), lineLimit(1)]}>
            {props.title}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: "subheadline" }),
              foregroundStyle(tint),
              lineLimit(1),
            ]}
          >
            {props.step}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: "caption" }),
              foregroundStyle("#9A9A9A"),
              lineLimit(1),
            ]}
          >
            {props.project}
          </Text>
        </VStack>
        <Spacer />
        {timer}
      </HStack>
    ),
    compactLeading: mascot(2),
    compactTrailing: timer,
    minimal: mascot(2),
    expandedLeading: mascot(4),
    expandedTrailing: timer,
    expandedCenter: (
      <Text modifiers={[font({ textStyle: "headline" }), lineLimit(1)]}>
        {props.title}
      </Text>
    ),
    expandedBottom: (
      <Text modifiers={[foregroundStyle(tint), lineLimit(1)]}>{props.step}</Text>
    ),
  };
}

export default createLiveActivity("SessionActivity", SessionActivity);
