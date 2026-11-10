use super::ResourceManager;

#[test]
fn handles_keep_values_and_do_not_reuse_removed_ids() {
    let mut resources = ResourceManager::default();
    let first = resources.add(String::from("first"));
    let second = resources.add(String::from("second"));
    assert_eq!(&resources[first], "first");
    assert_eq!(&resources[second], "second");
    assert_eq!(resources.remove(first), "first");

    let third = resources.add(String::from("third"));
    assert_ne!(first, third, "removed handles must not become valid again");
    assert_eq!(&resources[second], "second");
    assert_eq!(&resources[third], "third");
}

#[test]
fn mutable_handle_access_updates_only_selected_resource() {
    let mut resources = ResourceManager::default();
    let first = resources.add(10);
    let second = resources.add(20);
    resources[first] += 5;
    assert_eq!(resources[first], 15);
    assert_eq!(resources[second], 20);
}

#[test]
#[should_panic]
fn remove_unknown_handle_reports_failure() {
    let mut resources = ResourceManager::<u8>::default();
    resources.remove(42);
}

#[test]
#[should_panic]
fn removed_handle_cannot_be_indexed() {
    let mut resources = ResourceManager::default();
    let first = resources.add(1);
    resources.remove(first);
    let _ = resources[first];
}

#[test]
fn repeated_resource_churn_never_revives_stale_handles() {
    let mut resources = ResourceManager::default();
    let mut removed = Vec::new();

    for value in 0..256 {
        let id = resources.add(value);
        assert!(!removed.contains(&id), "a removed ID must not be reused");
        assert_eq!(resources.remove(id), value);
        removed.push(id);
    }

    let current = resources.add(999);
    assert!(!removed.contains(&current));
    assert_eq!(resources[current], 999);
}

#[test]
fn removing_one_resource_preserves_remaining_handles() {
    let mut resources = ResourceManager::default();
    let ids: Vec<_> = (0..32).map(|value| resources.add(value)).collect();

    for id in ids.iter().step_by(2) {
        let removed = resources.remove(*id);
        assert_eq!(removed, *id);
    }
    for id in ids.iter().skip(1).step_by(2) {
        assert_eq!(resources[*id], *id);
    }
}

#[test]
#[should_panic]
fn removing_the_same_handle_twice_panics() {
    let mut resources = ResourceManager::default();
    let id = resources.add(7);
    assert_eq!(resources.remove(id), 7);
    resources.remove(id);
}

#[test]
#[should_panic]
fn mutable_access_to_removed_handle_panics() {
    let mut resources = ResourceManager::default();
    let id = resources.add(12);
    resources.remove(id);
    resources[id] = 42;
}

#[test]
fn resource_id_overflow_does_not_mutate_live_resources() {
    let mut resources = ResourceManager::default();
    let live = resources.add("live");
    resources.id = usize::MAX;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        resources.add("must not be inserted");
    }));
    assert!(result.is_err(), "exhausted IDs must report failure");
    assert_eq!(resources[live], "live");
    assert_eq!(resources.resources.len(), 1);
    assert_eq!(resources.id, usize::MAX);
}

#[test]
fn deterministic_mixed_operations_preserve_live_resource_identity() {
    let mut resources = ResourceManager::default();
    let mut live = std::collections::BTreeMap::new();
    let mut stale = Vec::new();
    let mut seed: u32 = 0x1234_5678;

    for step in 0..512_u32 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        if live.is_empty() || seed % 3 != 0 {
            let id = resources.add(step);
            assert!(!live.contains_key(&id));
            assert!(!stale.contains(&id), "a stale ID must never be reused");
            live.insert(id, step);
        } else {
            let position = (seed as usize) % live.len();
            let id = *live.keys().nth(position).unwrap();
            let expected = live.remove(&id).unwrap();
            assert_eq!(resources.remove(id), expected);
            stale.push(id);
        }

        for (&id, &value) in &live {
            assert_eq!(resources[id], value);
        }
        assert_eq!(resources.resources.len(), live.len());
    }
}
