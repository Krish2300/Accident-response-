class AlertManager:

    def create_alerts(self, users, ambulance_id):
        """
        Creates emergency alerts for users
        inside the emergency corridor.
        """

        alerts = []

        for user in users:

            alert = {
                "user_id": user["user_id"],
                "ambulance_id": ambulance_id,
                "message": (
                    "Emergency ambulance approaching. "
                    "Please clear the route and allow passage."
                )
            }

            alerts.append(alert)

        return alerts