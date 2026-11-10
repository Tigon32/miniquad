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
