import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import type { RoadEventSeverity, RoadEventType } from '@/types/road-event';

export type ReportFormValues = {
  title: string;
  type: RoadEventType;
  severity: RoadEventSeverity;
  description?: string;
};

// Chip options are derived from the RoadEvent unions via Record<Union, string> label maps: a
// Record keyed by the union forces tsc to error if a member is missing, so display labels can't
// silently drift from types/road-event.ts. Only the display text is Croatian — the keys (the
// stored union values) are unchanged.
const TYPE_LABELS: Record<RoadEventType, string> = {
  construction: 'Gradilište',
  roadworks: 'Radovi',
  closure: 'Zatvoreno',
  accident: 'Nesreća',
  other: 'Ostalo',
};
const SEVERITY_LABELS: Record<RoadEventSeverity, string> = {
  low: 'Blago',
  medium: 'Umjereno',
  high: 'Ozbiljno',
};
const TYPE_OPTIONS = Object.keys(TYPE_LABELS) as RoadEventType[];
const SEVERITY_OPTIONS = Object.keys(SEVERITY_LABELS) as RoadEventSeverity[];

type Props = {
  visible: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: ReportFormValues) => void;
  onClose: () => void; // dismiss — the parent keeps the draft pin in place
};

export function ReportForm({ visible, submitting, error, onSubmit, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<RoadEventType>('construction');
  const [severity, setSeverity] = useState<RoadEventSeverity>('low');

  const textColor = useThemeColor({}, 'text');
  const iconColor = useThemeColor({}, 'icon');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');

  const canSubmit = title.trim().length > 0 && !submitting;

  function renderChips<T extends string>(
    options: T[],
    labels: Record<T, string>,
    selected: T,
    onSelect: (value: T) => void,
  ) {
    return (
      <View style={styles.chipRow}>
        {options.map((option) => {
          const active = option === selected;
          return (
            <Pressable
              key={option}
              onPress={() => onSelect(option)}
              disabled={submitting}
              style={[
                styles.chip,
                { borderColor: active ? tintColor : iconColor },
                active && { backgroundColor: tintColor },
              ]}>
              <ThemedText style={[styles.chipText, { color: active ? backgroundColor : textColor }]}>
                {labels[option]}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose} // Android hardware back
    >
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}>
        {/* Tap-outside dismiss — parent keeps the draft so the user can reposition + reopen. */}
        <Pressable style={styles.backdrop} onPress={onClose} />

        {/* Bottom-anchored card. maxHeight + inner ScrollView keeps every field reachable above
            the keyboard on small screens instead of clipping. */}
        <ThemedView style={styles.card}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.cardContent}>
            <ThemedText type="subtitle">Prijavi događaj na cesti</ThemedText>

            <ThemedText style={styles.label}>Naslov</ThemedText>
            <TextInput
              value={title}
              onChangeText={setTitle}
              editable={!submitting}
              autoFocus
              placeholder="npr. Ul. Ante Starčevića zatvorena"
              placeholderTextColor={iconColor}
              style={[styles.input, { color: textColor, borderColor: iconColor }]}
            />

            <ThemedText style={styles.label}>Opis</ThemedText>
            <TextInput
              value={description}
              onChangeText={setDescription}
              editable={!submitting}
              multiline
              numberOfLines={3}
              maxLength={300}
              textAlignVertical="top"
              placeholder="Što se događa? (nije obavezno)"
              placeholderTextColor={iconColor}
              style={[styles.input, styles.multiline, { color: textColor, borderColor: iconColor }]}
            />

            <ThemedText style={styles.label}>Vrsta</ThemedText>
            {renderChips(TYPE_OPTIONS, TYPE_LABELS, type, setType)}

            <ThemedText style={styles.label}>Ozbiljnost</ThemedText>
            {renderChips(SEVERITY_OPTIONS, SEVERITY_LABELS, severity, setSeverity)}

            {error && (
              <ThemedText style={[styles.error, { color: iconColor }]}>
                Slanje nije uspjelo: {error}
              </ThemedText>
            )}

            <View style={styles.actions}>
              <Pressable onPress={onClose} disabled={submitting} hitSlop={8}>
                <ThemedText type="link">Odustani</ThemedText>
              </Pressable>
              <Pressable
                onPress={() =>
                  onSubmit({
                    title: title.trim(),
                    type,
                    severity,
                    description: description.trim() || undefined,
                  })
                }
                disabled={!canSubmit}
                hitSlop={8}>
                <ThemedText type="link" style={!canSubmit && styles.disabled}>
                  {submitting ? 'Slanje…' : 'Pošalji'}
                </ThemedText>
              </Pressable>
            </View>
          </ScrollView>
        </ThemedView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: 'flex-end', // bottom-anchored card; padding lifts it above the keyboard
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  card: {
    maxHeight: '90%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  cardContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 8,
  },
  label: {
    marginTop: 8,
    opacity: 0.8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  multiline: {
    minHeight: 72, // ~3 lines; keeps the card compact while allowing up to maxLength=300
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: {
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 24,
    marginTop: 16,
  },
  disabled: {
    opacity: 0.4,
  },
});
