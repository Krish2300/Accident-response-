class UserDetection:

    def find_users_inside_corridor(self, users, corridor, geofence):
        """
        Finds users who are inside the emergency corridor.
        """

        nearby_users = []

        for user in users:

            latitude = user["latitude"]
            longitude = user["longitude"]

            for area in corridor:

                if geofence.is_inside(
                    latitude,
                    longitude,
                    area
                ):
                    nearby_users.append(user)
                    break

        return nearby_users