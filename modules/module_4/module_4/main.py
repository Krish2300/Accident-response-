from conversation_engine import ConversationEngine


def main():

    print("=" * 50)
    print("       EMERGENCY CONVERSATION ENGINE")
    print("=" * 50)

    engine = ConversationEngine()

    # -------------------------------------------------
    # SIMULATED INPUT FROM MODULE 3
    # -------------------------------------------------

    module_3_response = {
        "incident_type": "Road accident",
        "location": "Pala, Kerala",
        "conscious": None,
        "breathing": True,
        "severe_bleeding": None
    }

    # Send Module 3 information to Module 4
    engine.load_incident_data(module_3_response)

    print("\nInformation received from Module 3.")
    print("Module 4 is checking for missing information...\n")

    # -------------------------------------------------
    # MODULE 4 CONVERSATION
    # -------------------------------------------------

    while not engine.is_complete():

        question = engine.get_next_question()

        if question is None:
            break

        print("Question:")
        print(question["question"])

        answer = input("Your answer: ")

        success = engine.process_answer(
            question["key"],
            answer
        )

        if not success:
            print("\nI couldn't understand that answer.")
            print("Please try again.\n")
        else:
            print("\nAnswer recorded.\n")

    # -------------------------------------------------
    # FINAL PATIENT INFORMATION
    # -------------------------------------------------

    print("=" * 50)
    print("       PATIENT INFORMATION")
    print("=" * 50)

    patient_data = engine.get_patient_data()

    for key, value in patient_data.items():
        print(f"{key}: {value}")

    print("\nConversation completed.")
    print("=" * 50)


if __name__ == "__main__":
    main()